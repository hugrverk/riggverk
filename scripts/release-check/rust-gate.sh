#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$repo_root/src-tauri"

printf '\n==> rust gate\n'
cargo fmt --check
cargo check --locked
cargo clippy --locked --all-targets -- -D warnings
env -u AGENT_WORKSPACE_SMOKE -u AGENT_WORKSPACE_PATH cargo test --locked -- --test-threads=1
