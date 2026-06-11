#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

printf '\n==> workspace script action gate\n'
bash "$repo_root/scripts/check-workspace-script-actions.sh"

cd "$repo_root/src-tauri"

printf '\n==> rust gate\n'
cargo fmt --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
env -u AGENT_WORKSPACE_SMOKE -u AGENT_WORKSPACE_PATH cargo test -- --test-threads=1
