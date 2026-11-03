#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME RUSTUP_HOME
cd "$ROOT"

# resources/default-workspace/ as commit 2d85d94b (the pre-manifest ownership source) left it.
# A tree id, not a commit id: a history rewrite that leaves the bundle byte for byte keeps it.
source_bundle_tree=ee0eefd4b7c8d84f7dc40de05556aaa225d9b087
if ! git cat-file -e "$source_bundle_tree^{tree}"; then
  echo "FAIL: required pre-manifest source bundle is unavailable" >&2
  exit 1
fi

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/riggverk-pre-manifest.XXXXXX")"
trap 'rm -rf "$smoke_root"' EXIT
export HOME="$smoke_root/home"
export XDG_CONFIG_HOME="$smoke_root/xdg-config"
export XDG_DATA_HOME="$smoke_root/xdg-data"
export XDG_CACHE_HOME="$smoke_root/xdg-cache"
export RIGGVERK_WORKSPACE_PATH="$smoke_root/runtime"
export RIGGVERK_BACKUP_DIR="$smoke_root/backups"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

fixture="$smoke_root/source-commit-default-workspace"
mkdir -p "$fixture"
git archive "$source_bundle_tree" | tar -x -C "$fixture"

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

export RIGGVERK_HISTORICAL_FIXTURE_PATH="$fixture"
echo "==> real source-commit pre-manifest upgrade (isolated profile)"
# cargo exits 0 when the filter matches nothing; require one test that really ran.
smoke_log="$smoke_root/cargo-test.log"
if ! cargo test --locked --manifest-path src-tauri/Cargo.toml \
  real_source_commit_pre_manifest_upgrade_smoke --quiet -- --ignored --test-threads=1 --nocapture >"$smoke_log" 2>&1; then
  cat "$smoke_log" >&2
  echo "FAIL: real source-commit pre-manifest upgrade smoke failed" >&2
  exit 1
fi
cat "$smoke_log"
smoke_passed="$(sed -n 's/^test result: ok\. \([0-9][0-9]*\) passed.*/\1/p' "$smoke_log" | awk '{ total += $1 } END { print total + 0 }')"
if [ "$smoke_passed" -lt 1 ]; then
  echo "FAIL: pre-manifest upgrade smoke test filter matched no tests" >&2
  exit 1
fi

echo "==> pre-manifest upgrade smoke passed"
